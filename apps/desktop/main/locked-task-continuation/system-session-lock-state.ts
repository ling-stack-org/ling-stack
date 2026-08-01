import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read the current interactive-session lock state before Electron emits transitions. */
export async function readSystemSessionLocked(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | undefined> {
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileAsync(
        "/usr/sbin/ioreg",
        ["-n", "Root", "-d1", "-r", "-a"],
        { encoding: "utf8", maxBuffer: 512 * 1024, timeout: 1_500 },
      );
      const match = /<key>IOConsoleLocked<\/key>\s*<(true|false)\/>/u.exec(stdout);
      return match?.[1] === "true" ? true : match?.[1] === "false" ? false : undefined;
    }
    if (platform === "win32") {
      const script = [
        "$sessionId = (Get-Process -Id $PID).SessionId",
        "$locked = Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId }",
        "if ($locked) { 'true' } else { 'false' }",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 2_000, windowsHide: true },
      );
      const normalized = stdout.trim().toLowerCase();
      return normalized === "true" ? true : normalized === "false" ? false : undefined;
    }
    return false;
  } catch {
    return undefined;
  }
}
