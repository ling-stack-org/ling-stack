import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_CUA_DRIVER_PLUGIN_ID = "bundled:cua-driver";

export interface BundledPluginIndexEntry {
  readonly id: string;
  readonly sourceKind: "bundled";
  readonly packageRoot: string;
  readonly pinnedVersion: string;
  readonly defaultInstalled?: boolean;
}

export function listBundledPluginIndexEntries(): readonly BundledPluginIndexEntry[] {
  return [
    {
      id: BUNDLED_CUA_DRIVER_PLUGIN_ID,
      sourceKind: "bundled",
      packageRoot: resolveBundledPackageRoot("cua-driver"),
      pinnedVersion: "0.1.0",
      defaultInstalled: false,
    },
  ];
}

function resolveBundledPackageRoot(packageName: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "bundled", packageName),
    resolve(moduleDir.replace("/dist/", "/src/"), "bundled", packageName),
    resolve(process.cwd(), "src", "features", "plugins", "bundled", packageName),
    resolve(process.cwd(), "packages", "daemon", "src", "features", "plugins", "bundled", packageName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
