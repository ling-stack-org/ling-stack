import { parseBrowserAnnotation } from "../../shared/browser-annotations.js";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { browserInteger, browserRecord, browserString, parseDesktopBrowserScope, parseDesktopBrowserUrl } from "@ling-stack/contracts";
import type { DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace } from "../../shared/browser-capabilities.js";
import { DESKTOP_BROWSER_IPC_CHANNELS as CHANNELS } from "../../shared/ipc-channels.js";
import type { DesktopBrowserManager } from "./manager.js";
import { parseBrowserPreferences } from "./profile-store.js";

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
  const managementKeys: Record<string, readonly string[]> = { activate_workspace: [], deactivate_workspace: [], history_clear: ["since", "id"], clear_data: ["cookies", "cache", "storage", "history"], download_preferences: ["askBeforeDownload"],
    download_directory: [], download_cancel: ["id"], download_show: ["id"], device_permission: ["rule"], import_preview: [], import_apply: ["urls"], extension_install: [], extension_remove: ["id"] };
  const actions = [...Object.keys(managementKeys),"open", "open_link", "navigate", "activate", "close", "back", "forward", "reload", "stop", "take_control", "release_control", "open_external", "preferences", "annotate", "locate_annotation"];
  if (typeof action !== "string" || !actions.includes(action)) throw new Error("browser_action_invalid");
  const record = browserRecord(value, ["workspaceCwd", "scope", "action", ...(managementKeys[action] ?? (action === "annotate" ? ["tabId", "kind", "screenshot"] : action === "locate_annotation" ? ["annotation"] : action === "preferences" ? ["preferences"] : action === "open" || action === "open_link" ? ["url"] : action === "navigate" ? ["url", "tabId"] : ["tabId"]))]);
  const workspace = parseBrowserWorkspace({ workspaceCwd: record.workspaceCwd, scope: record.scope });
  if (action === "history_clear") return { ...workspace, action, since: browserInteger(record.since), ...(record.id === undefined ? {} : { id: browserString(record.id, 128) }) };
  if (action === "clear_data") {
    if (![record.cookies, record.cache, record.storage, record.history].every(value => typeof value === "boolean")) throw new Error("browser_clear_invalid");
    return { ...workspace, action, cookies: record.cookies as boolean, cache: record.cache as boolean, storage: record.storage as boolean, history: record.history as boolean };
  }
  if (action === "download_preferences") { if (typeof record.askBeforeDownload !== "boolean") throw new Error("browser_preferences_invalid"); return { ...workspace, action, askBeforeDownload: record.askBeforeDownload }; }
  if (action === "activate_workspace" || action === "deactivate_workspace" || action === "download_directory" || action === "import_preview" || action === "extension_install") return { ...workspace, action };
  if (action === "download_cancel" || action === "download_show" || action === "extension_remove") return { ...workspace, action, id: browserString(record.id, 128) };
  if (action === "import_apply") { if (!Array.isArray(record.urls) || record.urls.length > 100) throw new Error("browser_import_invalid"); return { ...workspace, action, urls: record.urls.map(parseDesktopBrowserUrl) }; }
  if (action === "device_permission") {
    const rule = browserRecord(record.rule, ["origin", "permission", "decision"]), origin = new URL(parseDesktopBrowserUrl(rule.origin)).origin;
    if (origin !== rule.origin || !["camera", "microphone", "geolocation", "notifications"].includes(String(rule.permission)) || !["ask", "allow", "deny"].includes(String(rule.decision))) throw new Error("browser_permission_invalid");
    return { ...workspace, action, rule: { origin, permission: rule.permission as "camera" | "microphone" | "geolocation" | "notifications", decision: rule.decision as "ask" | "allow" | "deny" } };
  }
  if (action === "annotate") {
    if ((record.kind !== "element" && record.kind !== "region") || typeof record.screenshot !== "boolean") throw new Error("browser_annotation_invalid");
    return { ...workspace, action, tabId: browserString(record.tabId, 128), kind: record.kind, screenshot: record.screenshot };
  }
  if (action === "locate_annotation") return { ...workspace, action, annotation: parseBrowserAnnotation(record.annotation) };
  if (action === "preferences") return { ...workspace, action, preferences: parseBrowserPreferences(record.preferences) };
  if (action === "open" || action === "open_link") return { ...workspace, action, url: parseDesktopBrowserUrl(record.url) };
  const tabId = browserString(record.tabId, 128);
  if (action === "navigate") return { ...workspace, action, tabId, url: parseDesktopBrowserUrl(record.url) };
  return { ...workspace, action: action as "activate" | "close" | "back" | "forward" | "reload" | "stop" | "take_control" | "release_control" | "open_external", tabId };
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
  readonly manager: Pick<DesktopBrowserManager, "workspace" | "act" | "reportViewport" | "onChanged" | "onAddressFocusRequested" | "hide">; readonly getMainWindow: () => BrowserWindow | undefined; readonly trustedDocumentUrl: string;
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
