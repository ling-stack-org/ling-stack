import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@agentclientprotocol/sdk";
// Only the Desktop bundler replaces this literal from its resolved SDK manifest.
const embeddedBundledAcpSdkVersion: string = "NO_PACKAGED_ACP_SDK_VERSION";

/** Follow the installed entry because SDK releases can change their dist layout. */
export function readInstalledAcpSdkVersion(entryUrl?: string): string {
  if (embeddedBundledAcpSdkVersion !== "NO_PACKAGED_ACP_SDK_VERSION") return embeddedBundledAcpSdkVersion;
  entryUrl ??= import.meta.resolve(packageName);
  let directory = dirname(fileURLToPath(entryUrl));
  while (true) {
    let manifest: { name?: unknown; version?: unknown } | undefined;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (manifest?.name === packageName) {
      if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
        throw new Error(`Invalid ${packageName} version in ${directory}`);
      }
      return manifest.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Unable to find ${packageName} manifest for ${entryUrl}`);
    directory = parent;
  }
}
