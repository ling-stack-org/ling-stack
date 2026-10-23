import { execFile } from "node:child_process";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Publish an owned staging directory without replacing a pre-existing output. */
export async function publishStagedDirectory(candidate, output) {
  let reserved = false;
  if (process.platform === "win32") {
    // Node's Windows rename uses REPLACE_EXISTING. Directory.Move uses the
    // non-replacing Win32 move, refusing existing files and directories atomically.
    // Paths travel as environment data, never as PowerShell command text.
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error("gstack_publication_windows_system_root_required");
    const command = "$ErrorActionPreference = 'Stop'; [System.IO.Directory]::Move($env:LING_GSTACK_PUBLICATION_CANDIDATE, $env:LING_GSTACK_PUBLICATION_OUTPUT)";
    await execute(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { env: { ...process.env, LING_GSTACK_PUBLICATION_CANDIDATE: candidate, LING_GSTACK_PUBLICATION_OUTPUT: output },
        timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return;
  }
  // POSIX can replace an empty directory, so reserve it exclusively first.
  await mkdir(output);
  reserved = true;
  try {
    await rename(candidate, output);
    reserved = false;
  } catch (error) {
    if (reserved) {
      try { await rmdir(output); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Staged directory publication and reservation cleanup failed"); }
    }
    throw error;
  }
}
