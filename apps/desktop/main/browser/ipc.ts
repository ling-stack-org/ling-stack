import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { browserInteger, browserRecord, browserString, parseDesktopBrowserScope, parseDesktopBrowserUrl } from "@ling-stack/contracts";
import type { DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace } from "../../shared/browser-capabilities.js";
import { DESKTOP_BROWSER_IPC_CHANNELS as CHANNELS } from "../../shared/ipc-channels.js";
import type { DesktopBrowserManager } from "./manager.js";

export function assertBrowserIpcSender(event: Pick<IpcMainInvokeEvent | IpcMainEvent, "sender" | "senderFrame">, window: BrowserWindow | undefined, trustedDocumentUrl: string): void {
  const contents = window?.webContents;
  const actual = contents?.getURL();
  const normalize = (value: string): string => { const url = new URL(value); url.search = url.hash = ""; return url.href; };
  if (!window || window.isDestroyed() || !contents || contents.isDestroyed() || event.sender !== contents
    || !event.senderFrame || event.senderFrame !== contents.mainFrame || event.senderFrame.detached || event.senderFrame.url !== actual
    || !actual?.startsWith("file:") || normalize(actual) !== normalize(trustedDocumentUrl)) throw new Error("browser_ipc_forbidden");
}

export function parseBrowserWorkspace(value: unknown): DesktopBrowserWorkspace {
  const record = browserRecord(value, ["workspaceCwd", "scope"]);
  return { workspaceCwd: browserString(record.workspaceCwd, 4096), scope: parseDesktopBrowserScope(record.scope) };
}

export function parseBrowserUserAction(value: unknown): DesktopBrowserUserAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_request_invalid");
  const action = (value as { action?: unknown }).action;
  const actions = ["open", "navigate", "activate", "close", "back", "forward", "reload", "stop", "take_control", "release_control", "open_external"];
  if (typeof action !== "string" || !actions.includes(action)) throw new Error("browser_action_invalid");
  const record = browserRecord(value, ["workspaceCwd", "scope", "action", ...(action === "open" ? ["url"] : action === "navigate" ? ["url", "tabId"] : ["tabId"])]);
  const workspace = parseBrowserWorkspace({ workspaceCwd: record.workspaceCwd, scope: record.scope });
  if (action === "open") return { ...workspace, action, url: parseDesktopBrowserUrl(record.url) };
  const tabId = browserString(record.tabId, 128);
  if (action === "navigate") return { ...workspace, action, tabId, url: parseDesktopBrowserUrl(record.url) };
  return { ...workspace, action: action as Exclude<DesktopBrowserUserAction["action"], "open" | "navigate">, tabId };
}

export function parseBrowserViewport(value: unknown): DesktopBrowserViewport {
  const record = browserRecord(value, ["workspaceCwd", "scope", "generation", "tabId", "visible", "bounds"]);
  const bounds = browserRecord(record.bounds, ["x", "y", "width", "height"]);
  if (typeof record.visible !== "boolean") throw new Error("browser_viewport_invalid");
  const coordinate = (value: unknown, min: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > 100_000) throw new Error("browser_viewport_invalid");
    return value;
  };
  return { ...parseBrowserWorkspace({ workspaceCwd: record.workspaceCwd, scope: record.scope }), generation: browserInteger(record.generation, 1),
    ...(record.tabId === undefined ? {} : { tabId: browserString(record.tabId, 128) }), visible: record.visible,
    bounds: { x: coordinate(bounds.x, -100_000), y: coordinate(bounds.y, -100_000), width: coordinate(bounds.width, 0), height: coordinate(bounds.height, 0) } };
}

export function registerDesktopBrowserIpc(input: { readonly ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
  readonly manager: DesktopBrowserManager; readonly getMainWindow: () => BrowserWindow | undefined; readonly trustedDocumentUrl: string;
  readonly onDiagnostic?: (code: string) => void }): () => void {
  const assertSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => assertBrowserIpcSender(event, input.getMainWindow(), input.trustedDocumentUrl);
  input.ipcMain.handle(CHANNELS.state, (event, value: unknown) => { assertSender(event); return input.manager.workspace(parseBrowserWorkspace(value)); });
  input.ipcMain.handle(CHANNELS.act, async (event, value: unknown) => {
    assertSender(event);
    const result = await input.manager.act(parseBrowserUserAction(value), () => assertSender(event));
    assertSender(event); return result;
  });
  const viewport = (event: IpcMainEvent, value: unknown): void => {
    try { assertSender(event); input.manager.reportViewport(parseBrowserViewport(value)); }
    catch (error) { input.onDiagnostic?.(error instanceof Error && /^browser_[a-z_]+$/u.test(error.message) ? error.message : "browser_viewport_rejected"); }
  };
  input.ipcMain.on(CHANNELS.viewport, viewport);
  const unsubscribe = input.manager.onChanged(() => {
    const owner = input.getMainWindow();
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(CHANNELS.changed);
  });
  const unsubscribeAddress = input.manager.onAddressFocusRequested(() => {
    const owner = input.getMainWindow();
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(CHANNELS.focusAddress);
  });
  return () => { unsubscribe(); unsubscribeAddress(); input.manager.hide(); input.ipcMain.removeHandler(CHANNELS.state); input.ipcMain.removeHandler(CHANNELS.act); input.ipcMain.removeListener(CHANNELS.viewport, viewport); };
}
