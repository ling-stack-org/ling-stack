import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEngineProfileConfiguration } from "@ling-stack/contracts";
import type { LingStackUserConfigPaths } from "@ling-stack/core";

/** Auth stays with the selected host profile, never in a workspace or the system CLI home. */
export async function prepareNativeAuthHome(paths: LingStackUserConfigPaths, configuration: ExecutionEngineProfileConfiguration): Promise<string> {
  await mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
  let directory = await realpath(paths.rootDir);
  for (const part of ["state", "execution-engines", configuration.engineId, "auth", configuration.authProfileId]) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("engine_auth_home_invalid");
  }
  const info = await lstat(directory);
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error("engine_auth_home_invalid");
  }
  return directory;
}
