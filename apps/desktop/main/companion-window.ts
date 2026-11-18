import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, WebContents, WebFrameMain, WebRequest } from "electron";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DesktopCommandResult, DesktopRect } from "../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";

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

export function registerCompanionWindowIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly webIndexPath: string;
  readonly daemonBaseUrl: string;
  readonly getWorkArea: (owner: BrowserWindow) => DesktopRect;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly webRequest: Pick<WebRequest, "onBeforeSendHeaders">;
}): () => void {
  let companion: BrowserWindow | undefined;
  let workspace: string | undefined;
  let owner: BrowserWindow | undefined;
  const trustedMainUrl = pathToFileURL(input.webIndexPath).href;
  const companionUrl = new URL(trustedMainUrl);
  companionUrl.searchParams.set("companionWindow", "1");
  const rejected = { accepted: false, reason: "unauthorized_companion_window_sender" } as const;
  const close = (): void => {
    const window = companion;
    companion = undefined;
    workspace = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  };
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
    window.once("closed", () => {
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
  return () => {
    if (localDaemon) input.webRequest.onBeforeSendHeaders(networkFilter, null);
    owner?.off("closed", ownerClosed);
    close();
    for (const channel of [DESKTOP_IPC_CHANNELS.companionWindowOpen, DESKTOP_IPC_CHANNELS.companionWindowClose, DESKTOP_IPC_CHANNELS.companionWindowSettings]) input.ipcMain.removeHandler(channel);
  };
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
