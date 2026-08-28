import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import type { DesktopThemePackageFirstPaintState } from "../shared/theme-package-capabilities.js";
import { encodeDesktopThemePackageFirstPaintArgument } from "../shared/theme-package-first-paint.js";

const macosMainWindowTrafficLightPosition = Object.freeze({ x: 12, y: 17 });

export interface MainWindowFactoryInput {
  readonly backgroundColor?: string;
  readonly daemonBaseUrl: string;
  readonly themePackageFirstPaint: DesktopThemePackageFirstPaintState;
  readonly computerControlPlatform?: "macos" | "windows";
  readonly platform?: NodeJS.Platform;
  readonly webIndexPath: string;
  readonly createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly openExternal?: (url: string) => Promise<void> | void;
  readonly onWindowCreated?: (window: BrowserWindow) => void;
  readonly showWhenReady?: boolean;
}

export function buildMainWindowOptions(
  input: Pick<MainWindowFactoryInput, "backgroundColor" | "daemonBaseUrl" | "themePackageFirstPaint" | "computerControlPlatform">,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: input.backgroundColor ?? "#111315",
    show: false,
    ...(platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: macosMainWindowTrafficLightPosition,
        }
      : { titleBarStyle: "default" as const }),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/main-window.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--ling-daemon-base-url=${input.daemonBaseUrl}`,
        encodeDesktopThemePackageFirstPaintArgument(input.themePackageFirstPaint),
        ...(input.computerControlPlatform
          ? [`--ling-computer-control-platform=${input.computerControlPlatform}`]
          : []),
      ],
    },
  };
}

export async function createMainWindow(input: MainWindowFactoryInput): Promise<BrowserWindow> {
  const electron = input.createWindow && input.openExternal
    ? undefined
    : await import("electron");
  const createWindow = input.createWindow
    ?? ((options: BrowserWindowConstructorOptions) => new electron!.BrowserWindow(options));
  const openExternal = input.openExternal
    ?? ((url: string) => electron!.shell.openExternal(url));
  const platform = input.platform ?? process.platform;
  const window = createWindow(buildMainWindowOptions(input, platform));
  if (platform === "win32") {
    window.removeMenu();
  }
  input.onWindowCreated?.(window);
  if (input.showWhenReady !== false) {
    window.once("ready-to-show", () => window.show());
  }
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void openExternal(url);
    }
    return { action: "deny" };
  });
  await window.loadFile(input.webIndexPath);
  return window;
}
