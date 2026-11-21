import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, WebContents, WebFrameMain, WebRequest } from "electron";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CompanionNavigationRequest, CompanionWindowBounds, CompanionWindowGeometry, CompanionWindowLayoutRequest } from "../shared/companion-capabilities.js";
import type { DesktopCommandResult, DesktopRect } from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";

const COMPANION_MIN_WIDTH = 320;
const COMPANION_MIN_HEIGHT = 280;
const COMPANION_MAX_DIMENSION = 2_000;

export function buildCompanionWindowOptions(input: {
  readonly cwd: string;
  readonly daemonBaseUrl: string;
  readonly workArea: DesktopRect;
}): BrowserWindowConstructorOptions {
  const width = Math.min(760, input.workArea.width);
  const height = Math.min(680, input.workArea.height);
  return {
    width, height,
    x: input.workArea.x + input.workArea.width - width,
    y: input.workArea.y + input.workArea.height - height,
    minWidth: Math.min(320, width), minHeight: Math.min(480, height),
    title: "Ling Companion", show: false, frame: false, transparent: true,
    backgroundColor: "#00000000", alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: true, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/companion-window.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [
        `--ling-daemon-base-url=${input.daemonBaseUrl}`,
        `--ling-companion-cwd=${encodeURIComponent(input.cwd)}`,
      ],
    },
  };
}

/** Keep renderer-requested bounds inside the display work area. */
export function clampCompanionWindowBounds(
  bounds: CompanionWindowBounds,
  workArea: DesktopRect,
): CompanionWindowBounds {
  const width = clampDimension(bounds.width, workArea.width, COMPANION_MIN_WIDTH);
  const height = clampDimension(bounds.height, workArea.height, COMPANION_MIN_HEIGHT);
  const x = clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width);
  const y = clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
}

export function registerCompanionWindowIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly webIndexPath: string;
  readonly daemonBaseUrl: string;
  readonly getWorkArea: (owner: BrowserWindow) => DesktopRect;
  readonly getCursorScreenPoint?: () => { readonly x: number; readonly y: number };
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly webRequest: Pick<WebRequest, "onBeforeSendHeaders">;
}): () => void {
  let companion: BrowserWindow | undefined;
  let workspace: string | undefined;
  let owner: BrowserWindow | undefined;
  let pointerLayout: { readonly bounds: CompanionWindowBounds; readonly regions: readonly CompanionWindowBounds[]; readonly requestedPassthrough: boolean } | undefined;
  const trustedMainUrl = pathToFileURL(input.webIndexPath).href;
  const companionUrl = new URL(trustedMainUrl);
  companionUrl.searchParams.set("companionWindow", "1");
  const rejected = { accepted: false, reason: "unauthorized_companion_window_sender" } as const;
  const close = (): void => {
    const window = companion;
    companion = undefined;
    workspace = undefined;
    pointerLayout = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  };
  const updatePointerMode = (): void => {
    const window = companion;
    const cursor = input.getCursorScreenPoint?.();
    const layout = pointerLayout;
    if (!window || window.isDestroyed() || !cursor || !layout) return;
    const bounds = window.getBounds();
    const localX = cursor.x - bounds.x;
    const localY = cursor.y - bounds.y;
    const inVisibleRegion = layout.regions.some((region) =>
      localX >= region.x && localY >= region.y
      && localX <= region.x + region.width
      && localY <= region.y + region.height);
    const passthrough = layout.regions.length > 0 ? !inVisibleRegion : layout.requestedPassthrough;
    window.setIgnoreMouseEvents(passthrough, passthrough ? { forward: true } : undefined);
  };
  const pointerTimer = setInterval(updatePointerMode, 80);
  const ownerClosed = (): void => { close(); owner = undefined; };
  const daemon = new URL(input.daemonBaseUrl);
  const networkFilter = { urls: [`${daemon.origin}/*`] };
  const localDaemon = ["http:", "https:"].includes(daemon.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(daemon.hostname);
  if (localDaemon) {
    // Electron can omit the Origin of a file-backed renderer. Project only
    // the owned top-level documents onto the configured loopback daemon.
    input.webRequest.onBeforeSendHeaders(networkFilter, (details, callback) => {
      const url = new URL(details.url);
      const sender = details.webContents;
      const document = { sender, senderFrame: details.frame };
      const companionRoute = url.pathname === "/companions" || url.pathname.startsWith("/companions/")
        || url.pathname === "/companion-attention"
        || url.pathname === "/user-input-answers"
        || url.pathname === "/approvals" || url.pathname.startsWith("/approvals/")
        || ((url.pathname === "/teammates" || url.pathname === "/ai-teammates") && details.method === "GET");
      const headers = details.requestHeaders;
      const keys = Object.keys(headers).filter((name) => name.toLowerCase() === "origin");
      const opaqueOrigin = keys.length === 0 || (keys.length === 1 && headers[keys[0]] === "null");
      if (opaqueOrigin && url.origin === daemon.origin && sender?.id === details.webContentsId
        && (isOwner(document, input.getMainWindow(), trustedMainUrl)
          || (companionRoute && isOwner(document, companion, companionUrl.href)))) {
        callback({ requestHeaders: { ...headers, [keys[0] ?? "Origin"]: daemon.origin } });
      } else {
        callback({ requestHeaders: headers });
      }
    });
  }

  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowOpen, async (event, cwd: unknown): Promise<DesktopCommandResult> => {
    const main = input.getMainWindow();
    if (!isOwner(event, main, trustedMainUrl)) return rejected;
    if (typeof cwd !== "string" || cwd.length > 4096 || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) {
      return { accepted: false, reason: "invalid_companion_workspace" };
    }
    if (companion && !companion.isDestroyed() && workspace === cwd) {
      companion.show(); companion.focus();
      return { accepted: true };
    }
    close();
    if (owner !== main) {
      owner?.off("closed", ownerClosed);
      owner = main;
      owner!.once("closed", ownerClosed);
    }
    const window = input.createWindow(buildCompanionWindowOptions({ cwd, daemonBaseUrl: input.daemonBaseUrl, workArea: input.getWorkArea(main!) }));
    companion = window;
    workspace = cwd;
    window.removeMenu();
    window.webContents.on("will-navigate", (navigation) => navigation.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const publishGeometry = (): void => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.companionGeometryChanged, companionWindowGeometry(window, input.getWorkArea(window)));
      }
    };
    window.on("move", publishGeometry);
    window.on("resize", publishGeometry);
    window.on("show", publishGeometry);
    window.once("closed", () => {
      window.off("move", publishGeometry);
      window.off("resize", publishGeometry);
      window.off("show", publishGeometry);
      if (companion === window) { companion = undefined; workspace = undefined; }
    });
    try {
      await window.loadFile(input.webIndexPath, { query: { companionWindow: "1" } });
      if (companion !== window || window.isDestroyed() || !isOwner(event, main, trustedMainUrl)) {
        if (companion === window) close();
        return { accepted: false, reason: "companion_window_owner_closed" };
      }
      window.show();
      return { accepted: true };
    } catch {
      if (companion === window) close();
      return { accepted: false, reason: "companion_window_load_failed" };
    }
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowClose, (event): DesktopCommandResult => {
    if (!isOwner(event, companion, companionUrl.href)) return rejected;
    close();
    return { accepted: true };
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowSettings, (event): DesktopCommandResult => {
    if (!isOwner(event, companion, companionUrl.href)) return rejected;
    const main = input.getMainWindow();
    if (!main || main.isDestroyed()) return rejected;
    main.show(); main.focus();
    main.webContents.send(DESKTOP_IPC_CHANNELS.companionSettingsRequested);
    return { accepted: true };
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowGeometryGet, (event): CompanionWindowGeometry | undefined => {
    if (!isOwner(event, companion, companionUrl.href) || !companion) return undefined;
    return companionWindowGeometry(companion, input.getWorkArea(companion));
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowLayout, (event, request: unknown): DesktopCommandResult => {
    if (!isOwner(event, companion, companionUrl.href)) return rejected;
    const window = companion;
    const layout = parseCompanionWindowLayoutRequest(request);
    if (!window || !layout) return { accepted: false, reason: "invalid_companion_layout" };
    const bounds = clampCompanionWindowBounds(layout.bounds, input.getWorkArea(window));
    window.setBounds(bounds);
    pointerLayout = { bounds, regions: layout.regions, requestedPassthrough: layout.pointerPassthrough };
    window.setIgnoreMouseEvents(layout.pointerPassthrough, layout.pointerPassthrough ? { forward: true } : undefined);
    updatePointerMode();
    return { accepted: true };
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.companionWindowNavigate, (event, request: unknown): DesktopCommandResult => {
    if (!isOwner(event, companion, companionUrl.href)) return rejected;
    const parsed = parseCompanionNavigationRequest(request, workspace);
    const main = input.getMainWindow();
    if (!parsed || !main || main.isDestroyed()) return { accepted: false, reason: "invalid_companion_navigation" };
    main.show(); main.focus();
    main.webContents.send(DESKTOP_IPC_CHANNELS.companionNavigationRequested, parsed);
    return { accepted: true };
  });
  return () => {
    if (localDaemon) input.webRequest.onBeforeSendHeaders(networkFilter, null);
    owner?.off("closed", ownerClosed);
    close();
    clearInterval(pointerTimer);
    for (const channel of [DESKTOP_IPC_CHANNELS.companionWindowOpen, DESKTOP_IPC_CHANNELS.companionWindowClose, DESKTOP_IPC_CHANNELS.companionWindowSettings, DESKTOP_IPC_CHANNELS.companionWindowGeometryGet, DESKTOP_IPC_CHANNELS.companionWindowLayout, DESKTOP_IPC_CHANNELS.companionWindowNavigate]) input.ipcMain.removeHandler(channel);
  };
}

function parseCompanionWindowLayoutRequest(value: unknown): CompanionWindowLayoutRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CompanionWindowLayoutRequest>;
  const bounds = candidate.bounds;
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) return undefined;
  const { x, y, width, height } = bounds as Partial<CompanionWindowBounds>;
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  if (width! <= 0 || height! <= 0 || width! > COMPANION_MAX_DIMENSION || height! > COMPANION_MAX_DIMENSION) return undefined;
  if (typeof candidate.pointerPassthrough !== "boolean"
    || !isWindowRect(candidate.anchor)
    || !Array.isArray(candidate.regions)
    || candidate.regions.some((region) => !isWindowRect(region))) return undefined;
  return {
    bounds: { x: x!, y: y!, width: width!, height: height! },
    anchor: candidate.anchor,
    regions: candidate.regions,
    pointerPassthrough: candidate.pointerPassthrough,
  };
}

function isWindowRect(value: unknown): value is CompanionWindowBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rect = value as Partial<CompanionWindowBounds>;
  return [rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item))
    && rect.width! >= 0 && rect.height! >= 0;
}

function companionWindowGeometry(window: BrowserWindow, workArea: DesktopRect): CompanionWindowGeometry {
  return { bounds: window.getBounds(), workArea };
}

function parseCompanionNavigationRequest(value: unknown, workspace: string | undefined): CompanionNavigationRequest | undefined {
  if (!workspace || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CompanionNavigationRequest>;
  if (candidate.workspace !== workspace || (candidate.kind !== "conversation" && candidate.kind !== "source")) return undefined;
  const strings = [
    candidate.workspace, candidate.conversationId, candidate.channelId, candidate.threadId,
    candidate.sourceItemId, candidate.sourceId, candidate.approvalId, candidate.runId,
    candidate.reportId, candidate.workflowStepId, candidate.handoffId, candidate.workUnitId,
  ];
  if (strings.some((item) => item !== undefined && (typeof item !== "string" || item.length === 0 || item.length > 512 || /[\u0000-\u001f\u007f]/u.test(item)))) return undefined;
  if (candidate.kind === "conversation" && typeof candidate.conversationId !== "string") return undefined;
  if (candidate.kind === "source" && typeof candidate.sourceId !== "string" && typeof candidate.sourceItemId !== "string") return undefined;
  return {
    workspace,
    kind: candidate.kind,
    ...(candidate.conversationId ? { conversationId: candidate.conversationId } : {}),
    ...(candidate.channelId ? { channelId: candidate.channelId } : {}),
    ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
    ...(candidate.sourceItemId ? { sourceItemId: candidate.sourceItemId } : {}),
    ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
    ...(candidate.approvalId ? { approvalId: candidate.approvalId } : {}),
    ...(candidate.runId ? { runId: candidate.runId } : {}),
    ...(candidate.reportId ? { reportId: candidate.reportId } : {}),
    ...(candidate.workflowStepId ? { workflowStepId: candidate.workflowStepId } : {}),
    ...(candidate.handoffId ? { handoffId: candidate.handoffId } : {}),
    ...(candidate.workUnitId ? { workUnitId: candidate.workUnitId } : {}),
  };
}

function clampDimension(value: number, available: number, minimum: number): number {
  return Math.min(
    Math.max(1, Math.round(available)),
    Math.max(1, Math.round(minimum), Math.round(value)),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function isOwner(
  event: { readonly sender?: WebContents; readonly senderFrame?: WebFrameMain | null },
  window: BrowserWindow | undefined,
  trustedUrl: string,
): boolean {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  if (contents.isDestroyed() || event.sender !== contents || !event.senderFrame
    || event.senderFrame !== contents.mainFrame || event.senderFrame.detached) return false;
  try {
    const actual = new URL(contents.getURL()); actual.hash = "";
    return actual.href === trustedUrl && event.senderFrame.url === contents.getURL();
  } catch { return false; }
}
