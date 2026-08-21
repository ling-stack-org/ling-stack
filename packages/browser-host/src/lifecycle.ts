import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHROME_BROWSER_DEFAULT_EXTENSION_IDS,
  CHROME_BROWSER_NATIVE_HOST_NAME,
  CHROME_BROWSER_NATIVE_HOST_VERSION,
} from "@ling-stack/contracts";
import {
  browserHostManifestPaths,
  browserHostWindowsRegistryKeys,
  type BrowserHostPlatform,
} from "./paths.js";
import {
  restrictWindowsPathToCurrentUser,
  runBrowserHostCommand,
  type BrowserHostCommandRunner,
} from "./windows-acl.js";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BrowserHostInstallationStatus {
  readonly installed: boolean;
  readonly platform: BrowserHostPlatform;
  readonly hostPath: string;
  readonly manifestPaths: readonly string[];
  readonly missing: readonly string[];
}

export async function installBrowserHost(input: {
  readonly hostPath: string;
  readonly platform?: BrowserHostPlatform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
  readonly runCommand?: BrowserHostCommandRunner;
}): Promise<BrowserHostInstallationStatus> {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const hostPath = resolve(input.hostPath);
  await access(hostPath);
  if (platform === "darwin") await chmod(hostPath, 0o755);
  const manifest = createBrowserHostManifest(hostPath);
  const manifestPaths = browserHostManifestPaths({
    platform,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    ...(input.localAppData ? { localAppData: input.localAppData } : {}),
  });
  for (const manifestPath of manifestPaths) {
    await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (platform === "darwin") await chmod(manifestPath, 0o600);
  }
  if (platform === "win32") {
    const command = input.runCommand ?? runBrowserHostCommand;
    await restrictWindowsPathToCurrentUser(dirname(manifestPaths[0]!), { directory: true, runCommand: command });
    await restrictWindowsPathToCurrentUser(manifestPaths[0]!, { runCommand: command });
    for (const key of browserHostWindowsRegistryKeys) {
      await command("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPaths[0]!, "/f"]);
    }
  }
  return { installed: true, platform, hostPath, manifestPaths, missing: [] };
}

export async function browserHostStatus(input: {
  readonly hostPath: string;
  readonly platform?: BrowserHostPlatform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
  readonly runCommand?: BrowserHostCommandRunner;
}): Promise<BrowserHostInstallationStatus> {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const hostPath = resolve(input.hostPath);
  const manifestPaths = browserHostManifestPaths({
    platform,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    ...(input.localAppData ? { localAppData: input.localAppData } : {}),
  });
  const missing: string[] = [];
  if (!await pathExists(hostPath)) missing.push(hostPath);
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const allowedOrigins = Array.isArray(manifest.allowed_origins)
        ? manifest.allowed_origins.filter((value): value is string => typeof value === "string")
        : undefined;
      if (manifest.name !== CHROME_BROWSER_NATIVE_HOST_NAME
        || manifest.path !== hostPath
        || manifest.type !== "stdio"
        || !allowedOrigins
        || CHROME_BROWSER_DEFAULT_EXTENSION_IDS.some((id) => !allowedOrigins.includes(`chrome-extension://${id}/`))) {
        missing.push(manifestPath);
      }
    } catch {
      missing.push(manifestPath);
    }
  }
  if (platform === "win32") {
    const command = input.runCommand ?? runBrowserHostCommand;
    for (const key of browserHostWindowsRegistryKeys) {
      try {
        const result = await command("reg.exe", ["QUERY", key, "/ve"]);
        const stdout = result && typeof result === "object" ? result.stdout : "";
        if (!stdout.toLowerCase().includes(manifestPaths[0]!.toLowerCase())) missing.push(key);
      } catch {
        missing.push(key);
      }
    }
  }
  return { installed: missing.length === 0, platform, hostPath, manifestPaths, missing };
}

export async function uninstallBrowserHost(input: {
  readonly hostPath: string;
  readonly platform?: BrowserHostPlatform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
  readonly runCommand?: BrowserHostCommandRunner;
}): Promise<BrowserHostInstallationStatus> {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const hostPath = resolve(input.hostPath);
  const manifestPaths = browserHostManifestPaths({
    platform,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    ...(input.localAppData ? { localAppData: input.localAppData } : {}),
  });
  if (platform === "win32") {
    const command = input.runCommand ?? runBrowserHostCommand;
    for (const key of browserHostWindowsRegistryKeys) {
      await command("reg.exe", ["DELETE", key, "/f"], true);
    }
  }
  for (const manifestPath of manifestPaths) {
    if (await isOwnedManifest(manifestPath)) await rm(manifestPath, { force: true });
  }
  return browserHostStatus({ ...input, platform, hostPath });
}

export async function buildDevelopmentBrowserHost(input: {
  readonly platform?: BrowserHostPlatform;
  readonly outputPath?: string;
} = {}): Promise<string> {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const executableName = platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host";
  const outputPath = input.outputPath ?? join(packageRoot, "dist", "native", executableName);
  const manifestPath = join(packageRoot, "native", "Cargo.toml");
  await runBrowserHostCommand("cargo", ["build", "--release", "--manifest-path", manifestPath]);
  const builtPath = join(packageRoot, "native", "target", "release", executableName);
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(builtPath, outputPath);
  if (platform === "darwin") await chmod(outputPath, 0o755);
  return outputPath;
}

export function defaultDevelopmentBrowserHostPath(platform = supportedPlatform(process.platform)): string {
  return join(packageRoot, "dist", "native", platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host");
}

export function createBrowserHostManifest(hostPath: string): Readonly<Record<string, unknown>> {
  return {
    name: CHROME_BROWSER_NATIVE_HOST_NAME,
    description: `Ling Browser Host ${CHROME_BROWSER_NATIVE_HOST_VERSION}`,
    path: resolve(hostPath),
    type: "stdio",
    allowed_origins: CHROME_BROWSER_DEFAULT_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };
}

function supportedPlatform(platform: NodeJS.Platform): BrowserHostPlatform {
  if (platform === "darwin" || platform === "win32") return platform;
  throw new Error("browser_host_platform_unsupported");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isOwnedManifest(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return value.name === CHROME_BROWSER_NATIVE_HOST_NAME;
  } catch {
    return false;
  }
}
