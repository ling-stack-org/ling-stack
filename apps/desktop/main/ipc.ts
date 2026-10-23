import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain } from "electron";
import {
  COMPUTER_USE_HOST_OBSTACLE_KINDS,
  COMPUTER_USE_PIP_SURFACE_KINDS,
  COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES,
  isComputerUsePreviewLocale,
  type ComputerUseHostLayout,
  type ComputerUseHostObstacle,
  type ComputerUseHostObstacleKind,
  type ComputerUsePipDeckOwner,
  type ComputerUsePreviewReleaseMediaAck,
  type ComputerControlPermissionKind,
  type DesktopRect,
  type DesktopMobileAccessCapabilities,
  type DesktopWindowState,
} from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import type { ComputerUsePreviewCoordinator } from "./computer-use/coordinator.js";
import type { DesktopRuntime } from "./desktop-runtime.js";
import { DesktopNavigationIntentStore } from "./navigation-intent.js";
import { DesktopRendererThemeStore } from "./renderer-theme-store.js";
import { sendToLiveDesktopWindow } from "./safe-window-send.js";
import { registerExecutionEngineIpc } from "./execution-engines/ipc.js";
import { createHostExecutionEngineClient } from "./execution-engines/client.js";
import { registerLocalFileIpc } from "./local-files/ipc.js";

const MAX_HOST_OBSTACLES = 128;
const MAX_DESKTOP_COORDINATE = 1_000_000;
const MAX_DESKTOP_DIMENSION = 100_000;
const MAX_HOST_LAYOUT_AGE_MS = 5 * 60 * 1_000;
const MAX_HOST_LAYOUT_FUTURE_SKEW_MS = 60 * 1_000;

export function registerDesktopIpc(input: {
  readonly runtime: Pick<
    DesktopRuntime,
    | "status"
    | "restart"
    | "onStatusChanged"
    | "requestComputerControlPermissions"
    | "openComputerControlPermissionSettings"
    | "getLockedTaskContinuationPreferences"
    | "setContinueTasksWhileLocked"
    | "revokeLockedComputerControl"
  >;
  readonly computerUse: ComputerUsePreviewCoordinator;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly navigationIntents?: DesktopNavigationIntentStore;
  readonly themeStore?: DesktopRendererThemeStore;
  readonly mobileAccess?: DesktopMobileAccessCapabilities;
  readonly executionEngines?: { readonly baseUrl: string; readonly trustedDocumentUrl: string;
    readonly getAuthority: Parameters<typeof createHostExecutionEngineClient>[1] };
  readonly windowControlsEnabled?: boolean;
  readonly fixedComputerUseConversationId?: string;
  readonly ipcMainImpl?: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeAllListeners">;
}): () => void {
  const desktopIpcMain = input.ipcMainImpl ?? resolveIpcMain();
  const unregisterExecutionEngines = input.executionEngines ? registerExecutionEngineIpc({
    ipcMainImpl: desktopIpcMain, getMainWindow: input.getMainWindow,
    trustedDocumentUrl: input.executionEngines.trustedDocumentUrl,
    getClient: () => createHostExecutionEngineClient(input.executionEngines!.baseUrl, input.executionEngines!.getAuthority),
  }) : undefined;
  const navigationIntents = input.navigationIntents ?? new DesktopNavigationIntentStore();
  const unregisterLocalFiles = input.executionEngines ? registerLocalFileIpc({
    ipcMainImpl: desktopIpcMain,
    getMainWindow: input.getMainWindow,
    trustedDocumentUrl: input.executionEngines.trustedDocumentUrl,
  }) : undefined;
  const themeStore = input.themeStore ?? new DesktopRendererThemeStore();
  let pendingRendererSelectionObserved = false;
  let pendingRendererSelection: string | undefined;
  let pendingRendererSelectionApplied = false;
  let pendingRendererSelectionAppliedValue: string | undefined;
  let pendingRendererDeckOwnerObserved = false;
  let pendingRendererDeckOwner: ComputerUsePipDeckOwner | undefined;
  let pendingRendererDeckOwnerApplied = false;
  let pendingRendererDeckOwnerAppliedKey: string | undefined;
  const isMainWindowSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    input.getMainWindow()?.webContents.id === event.sender.id;
  const isPreviewSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    input.computerUse.ownsPreviewWebContents(event.sender.id);
  let windowControlOwner: BrowserWindow | undefined;
  const reportWindowState = (): void => {
    const state = readWindowState();
    if (state) {
      sendToLiveDesktopWindow(
        input.getMainWindow(),
        DESKTOP_IPC_CHANNELS.windowStateChanged,
        state,
      );
    }
  };
  const ensureWindowControlOwner = (): BrowserWindow | undefined => {
    const window = input.windowControlsEnabled ? input.getMainWindow() : undefined;
    if (!window || window.isDestroyed()) return undefined;
    if (windowControlOwner !== window) {
      windowControlOwner?.off("maximize", reportWindowState);
      windowControlOwner?.off("unmaximize", reportWindowState);
      windowControlOwner?.off("restore", reportWindowState);
      window.on("maximize", reportWindowState);
      window.on("unmaximize", reportWindowState);
      window.on("restore", reportWindowState);
      windowControlOwner = window;
    }
    return window;
  };
  const readWindowState = (): DesktopWindowState | undefined => {
    const window = ensureWindowControlOwner();
    return window ? { maximized: window.isMaximized() } : undefined;
  };
  const readWindowForControl = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ): BrowserWindow | undefined => {
    if (!input.windowControlsEnabled || !isMainWindowSender(event)) return undefined;
    return ensureWindowControlOwner();
  };

  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.daemonStatus, async (event) =>
    isMainWindowSender(event) ? input.runtime.status : { state: "disconnected", baseUrl: "", ownedByDesktop: false });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.daemonRestart, async (event) =>
    isMainWindowSender(event)
      ? input.runtime.restart()
      : { state: "disconnected", baseUrl: "", ownedByDesktop: false, message: "unauthorized_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessStatus, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.status();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessEnable, async (event, gatewayOrigin: unknown) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    if (!isHttpsOrigin(gatewayOrigin)) {
      throw new Error("invalid_mobile_gateway_origin");
    }
    return await input.mobileAccess!.enable(gatewayOrigin);
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessDisable, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.disable();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessPairingStart, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.startPairing();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessPairingConfirm, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.confirmPairing();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessPairingReject, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.rejectPairing();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.mobileAccessRevoke, async (event) => {
    assertMobileAccessSender(isMainWindowSender(event), input.mobileAccess);
    return await input.mobileAccess!.revoke();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.navigationIntentGet, async (event) =>
    isMainWindowSender(event) ? navigationIntents.getPendingIntent() : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.navigationIntentAck, async (event, requestId: unknown) => {
    if (!isMainWindowSender(event) || !isPositiveSafeInteger(requestId)) {
      return { accepted: false, reason: "unauthorized_or_invalid_navigation_intent" };
    }
    const result = navigationIntents.acknowledge(requestId);
    if (
      result.accepted
      && !navigationIntents.getPendingIntent()
      && pendingRendererSelectionObserved
      && (!pendingRendererSelectionApplied || pendingRendererSelectionAppliedValue !== pendingRendererSelection)
    ) {
      input.computerUse.reportSelectedConversation(pendingRendererSelection);
    }
    const pendingDeckOwnerKey = computerUseDeckOwnerKey(pendingRendererDeckOwner);
    if (
      result.accepted
      && !navigationIntents.getPendingIntent()
      && pendingRendererDeckOwnerObserved
      && (!pendingRendererDeckOwnerApplied || pendingRendererDeckOwnerAppliedKey !== pendingDeckOwnerKey)
    ) {
      input.computerUse.reportSelectedDeckOwner(pendingRendererDeckOwner);
    }
    if (result.accepted && !navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = false;
      pendingRendererSelection = undefined;
      pendingRendererSelectionApplied = false;
      pendingRendererSelectionAppliedValue = undefined;
      pendingRendererDeckOwnerObserved = false;
      pendingRendererDeckOwner = undefined;
      pendingRendererDeckOwnerApplied = false;
      pendingRendererDeckOwnerAppliedKey = undefined;
    }
    return result;
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.desktopThemeSnapshotGet, async (event) => {
    if (!isPreviewSender(event)) {
      return undefined;
    }
    themeStore.trackRenderer(event.sender);
    return themeStore.getSnapshot();
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.desktopThemeReport, (event, value: unknown) => {
    if (isMainWindowSender(event)) {
      themeStore.report(value);
    }
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.windowStateGet, async (event) =>
    isMainWindowSender(event) ? readWindowState() : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.windowMinimize, async (event) => {
    const window = readWindowForControl(event);
    if (!window) return { accepted: false, reason: "unauthorized_or_unsupported_window_control" };
    window.minimize();
    return { accepted: true };
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.windowToggleMaximize, async (event) => {
    const window = readWindowForControl(event);
    if (!window) return { accepted: false, reason: "unauthorized_or_unsupported_window_control" };
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return { accepted: true };
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.windowClose, async (event) => {
    const window = readWindowForControl(event);
    if (!window) return { accepted: false, reason: "unauthorized_or_unsupported_window_control" };
    window.close();
    return { accepted: true };
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseSummaryGet, async (event) =>
    isMainWindowSender(event) ? input.computerUse.getSummary() : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseAutoShowGet, async (event) =>
    isMainWindowSender(event) ? input.computerUse.getPreferences() : { previewAutoShow: true });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseAutoShowSet, async (event, enabled: unknown) => {
    if (!isMainWindowSender(event) || typeof enabled !== "boolean") {
      return { accepted: false, reason: "unauthorized_or_invalid_auto_show" };
    }
    return input.computerUse.setAutoShow(enabled);
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerControlRequestPermissions, async (event) =>
    isMainWindowSender(event)
      ? input.runtime.requestComputerControlPermissions()
      : { accepted: false, reason: "unauthorized_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerControlOpenPermissionSettings, async (event, permission: unknown) => {
    if (!isMainWindowSender(event) || !isComputerControlPermissionKind(permission)) {
      return { accepted: false, reason: "unauthorized_or_invalid_permission" };
    }
    return input.runtime.openComputerControlPermissionSettings(permission);
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerControlLockedTaskContinuationGet, async (event) =>
    isMainWindowSender(event)
      ? input.runtime.getLockedTaskContinuationPreferences()
      : { continueWhileLocked: true });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerControlLockedTaskContinuationSet, async (event, enabled: unknown) => {
    if (!isMainWindowSender(event) || typeof enabled !== "boolean") {
      return { accepted: false, reason: "unauthorized_or_invalid_locked_task_continuation" };
    }
    return input.runtime.setContinueTasksWhileLocked(enabled);
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewSnapshotGet, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.getRendererSnapshot()
      : undefined);
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewRetry, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.retryCapture()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewResetPosition, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.resetPosition()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewActivatePage, (event, pageId: unknown) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id) && isNonEmptyString(pageId)
      ? input.computerUse.activatePage(pageId.trim())
      : { accepted: false, reason: "unauthorized_or_invalid_page" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewClosePage, (event, pageId: unknown) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id) && isNonEmptyString(pageId)
      ? input.computerUse.dismissPage(pageId.trim())
      : { accepted: false, reason: "unauthorized_or_invalid_page" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewClose, (event) =>
    input.computerUse.ownsPreviewWebContents(event.sender.id)
      ? input.computerUse.closeCurrent()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportLocale, (event, locale: unknown) => {
    if (isMainWindowSender(event) && isComputerUsePreviewLocale(locale)) {
      input.computerUse.reportLocale(locale);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportSelectedDeckOwner, (event, owner: unknown) => {
    if (!isMainWindowSender(event)) {
      return;
    }
    const parsedOwner = readComputerUseDeckOwner(owner);
    if (owner !== undefined && owner !== null && !parsedOwner) {
      return;
    }
    const selectedOwner = input.fixedComputerUseConversationId
      ? { surfaceKind: "normal_conversation" as const, ownerId: input.fixedComputerUseConversationId }
      : parsedOwner;
    if (navigationIntents.getPendingIntent()) {
      pendingRendererDeckOwnerObserved = true;
      pendingRendererDeckOwner = selectedOwner;
    }
    if (!navigationIntents.acceptRendererSelection(selectedOwner?.ownerId)) {
      return;
    }
    const ownerToApply = !navigationIntents.getPendingIntent() && pendingRendererDeckOwnerObserved
      ? pendingRendererDeckOwner
      : selectedOwner;
    input.computerUse.reportSelectedDeckOwner(ownerToApply);
    pendingRendererDeckOwnerApplied = true;
    pendingRendererDeckOwnerAppliedKey = computerUseDeckOwnerKey(ownerToApply);
    if (!navigationIntents.getPendingIntent()) {
      pendingRendererDeckOwnerObserved = false;
      pendingRendererDeckOwner = undefined;
      pendingRendererDeckOwnerApplied = false;
      pendingRendererDeckOwnerAppliedKey = undefined;
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportSelectedConversation, (event, conversationId: unknown) => {
    if (!isMainWindowSender(event)) {
      return;
    }
    const selectedConversationId = input.fixedComputerUseConversationId ??
      (typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : undefined);
    if (navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = true;
      pendingRendererSelection = selectedConversationId;
    }
    if (!navigationIntents.acceptRendererSelection(selectedConversationId)) {
      return;
    }
    const selectionToApply = !navigationIntents.getPendingIntent() && pendingRendererSelectionObserved
      ? pendingRendererSelection
      : selectedConversationId;
    input.computerUse.reportSelectedConversation(selectionToApply);
    pendingRendererSelectionApplied = true;
    pendingRendererSelectionAppliedValue = selectionToApply;
    if (!navigationIntents.getPendingIntent()) {
      pendingRendererSelectionObserved = false;
      pendingRendererSelection = undefined;
      pendingRendererSelectionApplied = false;
      pendingRendererSelectionAppliedValue = undefined;
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, (event, layout: unknown) => {
    if (!isMainWindowSender(event)) {
      return;
    }
    const parsed = readHostLayout(layout);
    if (parsed) {
      input.computerUse.reportHostLayout(parsed);
    }
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseShow, async (event, sessionId: unknown) =>
    !isMainWindowSender(event)
      ? { accepted: false, reason: "unauthorized_sender" }
      : typeof sessionId === "string" ? input.computerUse.show(sessionId) : { accepted: false, reason: "bad_session_id" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseHide, async (event, sessionId: unknown) =>
    !isMainWindowSender(event)
      ? { accepted: false, reason: "unauthorized_sender" }
      : typeof sessionId === "string" ? input.computerUse.hide(sessionId) : { accepted: false, reason: "bad_session_id" });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseStop, async (event, sessionId: unknown) => {
    if (isPreviewSender(event)) {
      await input.runtime.revokeLockedComputerControl().catch(() => undefined);
      return input.computerUse.stopCurrent();
    }
    if (!isMainWindowSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    await input.runtime.revokeLockedComputerControl().catch(() => undefined);
    return typeof sessionId === "string" ? input.computerUse.stop(sessionId) : input.computerUse.stopCurrent();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseOpenOwnerConversation, async (event) => {
    if (!isMainWindowSender(event) && !isPreviewSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    return input.computerUse.openOwnerConversation();
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUseOpenPermissionSettings, async (event) => {
    if (!isMainWindowSender(event) && !isPreviewSender(event)) {
      return { accepted: false, reason: "unauthorized_sender" };
    }
    await input.computerUse.openPermissionSettings();
    return { accepted: true };
  });
  desktopIpcMain.handle(DESKTOP_IPC_CHANNELS.computerUsePreviewHide, async (event) =>
    isPreviewSender(event)
      ? input.computerUse.hideCurrent()
      : { accepted: false, reason: "unauthorized_preview_sender" });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, (event, value: unknown) => {
    if (!isPreviewSender(event)) {
      return;
    }
    const ack = readComputerUsePreviewReleaseMediaAck(value);
    if (ack) {
      input.computerUse.reportMediaReleased(ack, event.sender.id);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameReady, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportFrameReady(sessionId, revision, sourceGeneration);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportFrameActivity(sessionId, revision, sourceGeneration);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, (event, interaction: unknown) => {
    if (!input.computerUse.ownsPreviewWebContents(event.sender.id) || !isRecord(interaction)) {
      return;
    }
    const kind = interaction.kind;
    const active = interaction.active;
    if ((kind === "hover" || kind === "focus") && typeof active === "boolean") {
      input.computerUse.reportInteraction(kind, active);
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceEnded, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
    reason: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportSourceEnded(
        sessionId,
        revision,
        sourceGeneration,
        typeof reason === "string" ? reason : "source_ended",
      );
    }
  });
  desktopIpcMain.on(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceFailed, (
    event,
    sessionId: unknown,
    revision: unknown,
    sourceGeneration: unknown,
    reason: unknown,
  ) => {
    if (
      input.computerUse.ownsPreviewWebContents(event.sender.id) &&
      isNonEmptyString(sessionId) &&
      isNonNegativeSafeInteger(revision) &&
      isPositiveSafeInteger(sourceGeneration)
    ) {
      input.computerUse.reportSourceFailure(
        sessionId,
        revision,
        sourceGeneration,
        typeof reason === "string" ? reason : "source_failed",
      );
    }
  });

  const unsubscribeStatus = input.runtime.onStatusChanged((status) => {
    sendToLiveDesktopWindow(input.getMainWindow(), DESKTOP_IPC_CHANNELS.daemonStatus, status);
  });
  const unsubscribeNavigationIntents = navigationIntents.onIntentChanged((intent) => {
    pendingRendererSelectionObserved = false;
    pendingRendererSelection = undefined;
    pendingRendererSelectionApplied = false;
    pendingRendererSelectionAppliedValue = undefined;
    pendingRendererDeckOwnerObserved = false;
    pendingRendererDeckOwner = undefined;
    pendingRendererDeckOwnerApplied = false;
    pendingRendererDeckOwnerAppliedKey = undefined;
    sendToLiveDesktopWindow(
      input.getMainWindow(),
      DESKTOP_IPC_CHANNELS.navigationIntentChanged,
      intent,
    );
  });
  return () => {
    unregisterLocalFiles?.();
    unregisterExecutionEngines?.();
    unsubscribeStatus();
    unsubscribeNavigationIntents();
    windowControlOwner?.off("maximize", reportWindowState);
    windowControlOwner?.off("unmaximize", reportWindowState);
    windowControlOwner?.off("restore", reportWindowState);
    themeStore.dispose();
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      desktopIpcMain.removeHandler(channel);
      desktopIpcMain.removeAllListeners(channel);
    }
  };
}

function resolveIpcMain(): IpcMain {
  const require = createRequire(import.meta.url);
  const electron = require("electron") as { readonly ipcMain?: IpcMain };
  if (!electron.ipcMain) {
    throw new Error("electron_ipc_main_unavailable");
  }
  return electron.ipcMain;
}

function readComputerUseDeckOwner(value: unknown): ComputerUsePipDeckOwner | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const surfaceKind = value.surfaceKind;
  const ownerId = value.ownerId;
  if (
    typeof surfaceKind !== "string"
    || !COMPUTER_USE_PIP_SURFACE_KINDS.includes(surfaceKind as ComputerUsePipDeckOwner["surfaceKind"])
    || !isNonEmptyString(ownerId)
  ) {
    return undefined;
  }
  return {
    surfaceKind: surfaceKind as ComputerUsePipDeckOwner["surfaceKind"],
    ownerId: ownerId.trim(),
  };
}

function computerUseDeckOwnerKey(owner: ComputerUsePipDeckOwner | undefined): string | undefined {
  return owner ? `${owner.surfaceKind}\u0000${owner.ownerId}` : undefined;
}

function readHostLayout(value: unknown): ComputerUseHostLayout | undefined {
  if (!isRecord(value) || !Array.isArray(value.obstacles)) {
    return undefined;
  }
  const windowBounds = readRect(value.windowBounds);
  if (!windowBounds) {
    return undefined;
  }
  const obstacles = value.obstacles
    .slice(0, MAX_HOST_OBSTACLES)
    .map(readHostObstacle)
    .filter((obstacle): obstacle is ComputerUseHostObstacle => obstacle !== undefined);
  return {
    windowBounds,
    obstacles,
    reportedAt: readHostLayoutReportedAt(value.reportedAt),
  };
}

function readHostLayoutReportedAt(value: unknown): string {
  const now = Date.now();
  if (typeof value === "string") {
    const reportedAt = Date.parse(value);
    if (
      Number.isFinite(reportedAt)
      && reportedAt >= now - MAX_HOST_LAYOUT_AGE_MS
      && reportedAt <= now + MAX_HOST_LAYOUT_FUTURE_SKEW_MS
    ) {
      return value;
    }
  }
  return new Date(now).toISOString();
}

function readComputerUsePreviewReleaseMediaAck(
  value: unknown,
): ComputerUsePreviewReleaseMediaAck | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.requestId)
    || !isNonEmptyString(value.sessionId)
    || !isNonNegativeSafeInteger(value.sourceRevision)
    || !isPositiveSafeInteger(value.sourceGeneration)
    || !isComputerUsePreviewReleaseMediaStatus(value.status)
    || !isNonNegativeSafeInteger(value.releasedTrackCount)
    || typeof value.allTracksEnded !== "boolean"
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    sourceRevision: value.sourceRevision,
    sourceGeneration: value.sourceGeneration,
    status: value.status,
    releasedTrackCount: value.releasedTrackCount,
    allTracksEnded: value.allTracksEnded,
  };
}

function readHostObstacle(value: unknown): ComputerUseHostObstacle | undefined {
  const bounds = readRect(value);
  if (!bounds) {
    return undefined;
  }
  const kind = isRecord(value) && isComputerUseHostObstacleKind(value.kind)
    ? value.kind
    : "other";
  return { ...bounds, kind };
}

function readRect(value: unknown): DesktopRect | undefined {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.width)
    || !isFiniteNumber(value.height)
    || value.width <= 0
    || value.height <= 0
    || value.width > MAX_DESKTOP_DIMENSION
    || value.height > MAX_DESKTOP_DIMENSION
    || value.x < -MAX_DESKTOP_COORDINATE
    || value.y < -MAX_DESKTOP_COORDINATE
    || value.x + value.width > MAX_DESKTOP_COORDINATE
    || value.y + value.height > MAX_DESKTOP_COORDINATE
  ) {
    return undefined;
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function isComputerUseHostObstacleKind(value: unknown): value is ComputerUseHostObstacleKind {
  return typeof value === "string" && COMPUTER_USE_HOST_OBSTACLE_KINDS.some((kind) => kind === value);
}

function isComputerUsePreviewReleaseMediaStatus(
  value: unknown,
): value is ComputerUsePreviewReleaseMediaAck["status"] {
  return typeof value === "string"
    && COMPUTER_USE_PREVIEW_RELEASE_MEDIA_STATUSES.some((status) => status === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComputerControlPermissionKind(value: unknown): value is ComputerControlPermissionKind {
  return value === "accessibility" || value === "screen_recording";
}

function assertMobileAccessSender(
  authorized: boolean,
  mobileAccess: DesktopMobileAccessCapabilities | undefined,
): asserts mobileAccess is DesktopMobileAccessCapabilities {
  if (!authorized || !mobileAccess) {
    throw new Error("mobile_access_unauthorized_or_unavailable");
  }
}

function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}
