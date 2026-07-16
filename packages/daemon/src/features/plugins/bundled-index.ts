import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_CUA_DRIVER_PLUGIN_ID = "bundled:cua-driver";
export const DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY = "bundled";

export interface BundledPluginIndexEntry {
  readonly id: string;
  readonly sourceKind: "bundled";
  readonly packageRoot: string;
  readonly pinnedVersion: string;
  readonly defaultInstalled?: boolean;
}

export interface BundledPackageRootResolutionOptions {
  readonly moduleUrl?: string;
  readonly cwd?: string;
  readonly resourcesPath?: string;
  readonly pathExists?: (path: string) => boolean;
}

export function listBundledPluginIndexEntries(): readonly BundledPluginIndexEntry[] {
  return [
    {
      id: BUNDLED_CUA_DRIVER_PLUGIN_ID,
      sourceKind: "bundled",
      packageRoot: resolveBundledPackageRoot("cua-driver"),
      pinnedVersion: "0.2.0",
      defaultInstalled: false,
    },
  ];
}

export function resolveBundledPackageRoot(
  packageName: string,
  options: BundledPackageRootResolutionOptions = {},
): string {
  const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const resourcesPath = options.resourcesPath ?? readElectronResourcesPath();
  const cwd = options.cwd ?? process.cwd();
  const pathExists = options.pathExists ?? existsSync;
  const sourceModuleDir = moduleDir.replace(`${sep}dist${sep}`, `${sep}src${sep}`);
  const candidates = [
    ...(resourcesPath
      ? [resolve(resourcesPath, DESKTOP_BUNDLED_PLUGINS_RESOURCE_DIRECTORY, packageName)]
      : []),
    resolve(moduleDir, "bundled", packageName),
    resolve(sourceModuleDir, "bundled", packageName),
    resolve(cwd, "src", "features", "plugins", "bundled", packageName),
    resolve(cwd, "packages", "daemon", "src", "features", "plugins", "bundled", packageName),
  ];
  return candidates.find((candidate) => pathExists(candidate)) ?? candidates[0];
}

function readElectronResourcesPath(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: unknown }).resourcesPath;
  return typeof resourcesPath === "string" && resourcesPath.trim() ? resourcesPath : undefined;
}
