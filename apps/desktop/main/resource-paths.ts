import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { App } from "electron";

export interface DesktopResourcePaths {
  readonly webIndexPath: string;
  readonly daemonEntryPath: string;
  readonly previewIndexPath: string;
}

export async function resolveDesktopResourcePaths(app: Pick<App, "getAppPath" | "isPackaged">): Promise<DesktopResourcePaths> {
  const appPath = app.getAppPath();
  const resourcesRoot = app.isPackaged ? process.resourcesPath : resolve(appPath, "../..");
  const paths: DesktopResourcePaths = app.isPackaged
    ? {
        webIndexPath: resolve(resourcesRoot, "web/index.html"),
        daemonEntryPath: resolve(appPath, "dist/daemon/cli.mjs"),
        previewIndexPath: resolve(appPath, "dist/renderer/computer-use-preview/index.html"),
      }
    : {
        webIndexPath: resolve(appPath, "../web/dist/index.html"),
        daemonEntryPath: resolve(appPath, "dist/daemon/cli.mjs"),
        previewIndexPath: resolve(appPath, "dist/renderer/computer-use-preview/index.html"),
      };
  await Promise.all([access(paths.webIndexPath), access(paths.daemonEntryPath), access(paths.previewIndexPath)]);
  return paths;
}
