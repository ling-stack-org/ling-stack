import { homedir } from "node:os";
import { join } from "node:path";
import { CHROME_BROWSER_NATIVE_HOST_NAME } from "@ling-stack/contracts";

export type BrowserHostPlatform = "darwin" | "win32";

export function browserHostStateDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ".ling-stack", "browser-host");
}

export function browserHostRuntimeDescriptorPath(homeDirectory = homedir()): string {
  return join(browserHostStateDirectory(homeDirectory), "runtime-v1.json");
}

export function browserHostManifestPaths(input: {
  readonly platform: BrowserHostPlatform;
  readonly homeDirectory?: string;
  readonly localAppData?: string;
}): readonly string[] {
  const homeDirectory = input.homeDirectory ?? homedir();
  if (input.platform === "darwin") {
    return [
      join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${CHROME_BROWSER_NATIVE_HOST_NAME}.json`),
      join(homeDirectory, "Library", "Application Support", "Chromium", "NativeMessagingHosts", `${CHROME_BROWSER_NATIVE_HOST_NAME}.json`),
    ];
  }
  const localAppData = input.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("browser_host_local_app_data_missing");
  return [join(localAppData, "Ling Stack", "browser-host", `${CHROME_BROWSER_NATIVE_HOST_NAME}.json`)];
}

export const browserHostWindowsRegistryKeys = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_BROWSER_NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${CHROME_BROWSER_NATIVE_HOST_NAME}`,
] as const;
