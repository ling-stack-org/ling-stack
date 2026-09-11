import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { App } from "electron";

export interface DesktopResourcePaths {
  /** Root passed to private bundled-provider path resolution. */
  readonly resourcesRoot: string;
  readonly webIndexPath: string;
  readonly daemonEntryPath: string;
  readonly previewIndexPath: string;
  readonly browserHostPath: string;
}

export class DesktopResourceResolutionError extends Error {
  constructor(cause: unknown) {
    super("desktop_resource_missing", { cause });
    this.name = "DesktopResourceResolutionError";
  }
}

export async function resolveDesktopResourcePaths(
  app: Pick<App, "getAppPath" | "isPackaged">,
  packagedResourcesPath: string = process.resourcesPath,
): Promise<DesktopResourcePaths> {
  const appPath = app.getAppPath();
  const resourcesRoot = resolveDesktopResourcesRoot(app, packagedResourcesPath);
  const paths: DesktopResourcePaths = app.isPackaged
    ? {
        resourcesRoot,
        webIndexPath: resolve(resourcesRoot, "web/index.html"),
        daemonEntryPath: resolve(appPath, "dist/daemon/cli.mjs"),
        previewIndexPath: resolve(appPath, "dist/renderer/computer-use-preview/index.html"),
        browserHostPath: resolve(resourcesRoot, "browser-host", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
      }
    : {
        resourcesRoot,
        webIndexPath: resolve(appPath, "../web/dist/index.html"),
        daemonEntryPath: resolve(appPath, "dist/daemon/cli.mjs"),
        previewIndexPath: resolve(appPath, "dist/renderer/computer-use-preview/index.html"),
        browserHostPath: resolve(appPath, "../../packages/browser-host/dist/native", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
      };
  try {
    await Promise.all([
      access(paths.webIndexPath),
      access(paths.daemonEntryPath),
      access(paths.previewIndexPath),
      ...(app.isPackaged ? [access(paths.browserHostPath)] : []),
      ...(app.isPackaged && process.platform === "darwin"
        ? [
            access(resolve(paths.resourcesRoot, "restricted-command/ling-sandbox-runner")),
            access(resolve(paths.resourcesRoot, "restricted-command/manifest.json")),
          ]
        : []),
    ]);
  } catch (error) {
    throw new DesktopResourceResolutionError(error);
  }
  return paths;
}

export function resolveDesktopResourcesRoot(
  app: Pick<App, "getAppPath" | "isPackaged">,
  packagedResourcesPath: string = process.resourcesPath,
): string {
  return app.isPackaged
    ? resolve(packagedResourcesPath)
    : resolve(app.getAppPath(), "resources");
}
