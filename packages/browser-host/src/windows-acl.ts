import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserHostCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type BrowserHostCommandRunner = (
  file: string,
  args: readonly string[],
  ignoreMissing?: boolean,
) => Promise<BrowserHostCommandResult | void>;

export async function restrictWindowsPathToCurrentUser(
  path: string,
  input: {
    readonly directory?: boolean;
    readonly runCommand?: BrowserHostCommandRunner;
    readonly username?: string;
  } = {},
): Promise<void> {
  const username = input.username ?? process.env.USERNAME;
  if (!username) throw new Error("browser_host_windows_username_missing");
  const permission = input.directory ? "(OI)(CI)F" : "F";
  await (input.runCommand ?? runBrowserHostCommand)("icacls.exe", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${username}:${permission}`,
  ]);
}

export async function runBrowserHostCommand(
  file: string,
  args: readonly string[],
  ignoreMissing = false,
): Promise<BrowserHostCommandResult> {
  try {
    const result = await execFileAsync(file, [...args], { windowsHide: true });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    if (ignoreMissing && error && typeof error === "object" && "code" in error && error.code === 1) {
      return { stdout: "", stderr: "" };
    }
    throw error;
  }
}
