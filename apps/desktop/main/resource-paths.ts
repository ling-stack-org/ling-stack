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
  readonly engineSupervisorPath?: string;
  readonly imageSanitizerPath: string;
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
        imageSanitizerPath: resolve(resourcesRoot, "image-sanitizer", imageExecutable()),
        browserHostPath: resolve(resourcesRoot, "browser-host", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
        ...(process.platform === "win32" ? { engineSupervisorPath: resolve(resourcesRoot, "engine-supervisor/ling-engine-supervisor.exe") } : {}),
      }
    : {
        resourcesRoot,
        webIndexPath: resolve(appPath, "../web/dist/index.html"),
        daemonEntryPath: resolve(appPath, "dist/daemon/cli.mjs"),
        previewIndexPath: resolve(appPath, "dist/renderer/computer-use-preview/index.html"),
        imageSanitizerPath: resolve(appPath, "../../packages/daemon/dist/native/image-sanitizer", imageExecutable()),
        browserHostPath: resolve(appPath, "../../packages/browser-host/dist/native", process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"),
        ...(process.platform === "win32" ? { engineSupervisorPath: resolve(appPath, "../../packages/daemon/dist/native/engine-supervisor/ling-engine-supervisor.exe") } : {}),
      };
  try {
    await Promise.all([
      access(paths.webIndexPath),
      access(paths.daemonEntryPath),
      access(paths.previewIndexPath),
      ...(app.isPackaged ? [access(paths.browserHostPath), access(paths.imageSanitizerPath),
        access(resolve(resourcesRoot, "image-sanitizer/build-metadata.json")),
        access(resolve(resourcesRoot, "image-sanitizer/THIRD_PARTY_LICENSES.txt"))] : []),
      ...(app.isPackaged && process.platform === "darwin"
        ? [
            access(resolve(paths.resourcesRoot, "restricted-command/ling-sandbox-runner")),
            access(resolve(paths.resourcesRoot, "restricted-command/manifest.json")),
            access(resolve(paths.resourcesRoot, "office-local/office-local.node")),
            access(resolve(paths.resourcesRoot, "office-local/build-manifest.json")),
            access(resolve(paths.resourcesRoot, "office-local/source")),
          ]
        : []),
      ...(app.isPackaged && paths.engineSupervisorPath ? [access(paths.engineSupervisorPath)] : []),
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

function imageExecutable(): string { return process.platform === "win32" ? "ling-image-sanitizer.exe" : "ling-image-sanitizer"; }
