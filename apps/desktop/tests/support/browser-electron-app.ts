import { app, BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DesktopBrowserManager } from "../../main/browser/manager.js";
import { DesktopBrowserWorkspaceRuntime } from "../../main/browser/workspace-runtime.js";
import { registerDesktopBrowserIpc } from "../../main/browser/ipc.js";
import { bindDesktopBrowserWindow } from "../../main/browser/window-lifecycle.js";

export interface BrowserElectronHarness {
  readonly manager: DesktopBrowserWorkspaceRuntime;
  readonly window: BrowserWindow;
  createManager(workspaceCwd: string): DesktopBrowserManager;
}
declare global { var lingBrowserHarness: BrowserElectronHarness; }

const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
app.setPath("userData", required("LING_BROWSER_TEST_PROFILE"));
const downloads = join(required("LING_BROWSER_TEST_PROFILE"), "downloads"); mkdirSync(downloads, { recursive: true }); app.setPath("downloads", downloads);
await app.whenReady();
const window = new BrowserWindow({ width: 1440, height: 960, webPreferences: { sandbox: true, contextIsolation: true,
  nodeIntegration: false, preload: required("LING_BROWSER_TEST_PRELOAD") } });
const createManager = (workspaceCwd: string): DesktopBrowserManager => new DesktopBrowserManager({ workspaceCwd,
  desktopInstanceId: "browser-electron-test", daemonBaseUrl: required("LING_BROWSER_TEST_DAEMON"), getMainWindow: () => window,
  profileDirectory: join(app.getPath("userData"), "browser-profiles") });
const runtime = new DesktopBrowserWorkspaceRuntime({ workspaceCwd: required("LING_BROWSER_TEST_WORKSPACE"),
  desktopInstanceId: "browser-electron-test", daemonBaseUrl: required("LING_BROWSER_TEST_DAEMON"), getMainWindow: () => window,
  profileDirectory: join(app.getPath("userData"), "browser-profiles"), bridgeToken: "browser-electron-test-token" });
const manager = runtime.manager;
bindDesktopBrowserWindow(window, manager);
registerDesktopBrowserIpc({ ipcMain: (await import("electron")).ipcMain, manager, getMainWindow: () => window,
  trustedDocumentUrl: pathToFileURL(required("LING_BROWSER_TEST_HTML")).href, onDiagnostic: code => console.error(code) });
globalThis.lingBrowserHarness = { manager, window, createManager };
await runtime.start();
await window.loadFile(required("LING_BROWSER_TEST_HTML"), { query: { native: "1", workspace: required("LING_BROWSER_TEST_WORKSPACE") } });
let stopping = false;
app.on("before-quit", event => {
  if (stopping) return;
  event.preventDefault(); stopping = true;
  void runtime.stop().finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
