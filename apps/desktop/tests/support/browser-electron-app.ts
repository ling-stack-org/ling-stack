import { app, BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";
import { DesktopBrowserManager } from "../../main/browser/manager.js";
import { DesktopBrowserRuntime } from "../../main/browser/runtime.js";
import { registerDesktopBrowserIpc } from "../../main/browser/ipc.js";
import { bindDesktopBrowserWindow } from "../../main/browser/window-lifecycle.js";

export interface BrowserElectronHarness {
  readonly manager: DesktopBrowserManager;
  readonly window: BrowserWindow;
  createManager(workspaceCwd: string): DesktopBrowserManager;
}
declare global { var lingBrowserHarness: BrowserElectronHarness; }

const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
app.setPath("userData", required("LING_BROWSER_TEST_PROFILE"));
await app.whenReady();
const window = new BrowserWindow({ width: 1440, height: 960, webPreferences: { sandbox: true, contextIsolation: true,
  nodeIntegration: false, preload: required("LING_BROWSER_TEST_PRELOAD") } });
const createManager = (workspaceCwd: string): DesktopBrowserManager => new DesktopBrowserManager({ workspaceCwd,
  desktopInstanceId: "browser-electron-test", daemonBaseUrl: required("LING_BROWSER_TEST_DAEMON"), getMainWindow: () => window });
const manager = createManager(required("LING_BROWSER_TEST_WORKSPACE"));
bindDesktopBrowserWindow(window, manager);
const runtime = new DesktopBrowserRuntime(manager, { daemonBaseUrl: required("LING_BROWSER_TEST_DAEMON"), bridgeToken: "browser-electron-test-token" });
registerDesktopBrowserIpc({ ipcMain: (await import("electron")).ipcMain, manager, getMainWindow: () => window,
  trustedDocumentUrl: pathToFileURL(required("LING_BROWSER_TEST_HTML")).href, onDiagnostic: code => console.error(code) });
globalThis.lingBrowserHarness = { manager, window, createManager };
await runtime.start();
await window.loadFile(required("LING_BROWSER_TEST_HTML"), { query: { native: "1", workspace: required("LING_BROWSER_TEST_WORKSPACE") } });
app.on("window-all-closed", () => { void runtime.stop().finally(() => app.quit()); });
