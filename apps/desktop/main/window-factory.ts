import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";

export interface MainWindowFactoryInput {
  readonly daemonBaseUrl: string;
  readonly webIndexPath: string;
  readonly createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly onWindowCreated?: (window: BrowserWindow) => void;
  readonly showWhenReady?: boolean;
}

export async function createMainWindow(input: MainWindowFactoryInput): Promise<BrowserWindow> {
  const createWindow = input.createWindow ?? ((options) => new BrowserWindow(options));
  const window = createWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0f1115",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/main-window.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--ling-daemon-base-url=${input.daemonBaseUrl}`],
    },
  });
  input.onWindowCreated?.(window);
  if (input.showWhenReady !== false) {
    window.once("ready-to-show", () => window.show());
  }
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  await window.loadFile(input.webIndexPath);
  return window;
}
