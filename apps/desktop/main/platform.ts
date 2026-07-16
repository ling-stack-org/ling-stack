import type { DesktopPlatform } from "../shared/desktop-capabilities.js";

export function desktopPlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "linux";
}
