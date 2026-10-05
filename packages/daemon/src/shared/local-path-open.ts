import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { defineProtectedHostActorEntry } from "../runtime/sandbox/protected-host-actor-inventory.js";

/** Original directory-open UI producer; external/raw, not a verified human gesture or controlled run tool. */
export const LOCAL_PATH_OPEN_ACTOR_ENTRY = defineProtectedHostActorEntry("local_path_open",
  (command: string, args: readonly string[]) => spawn(command, [...args], {
    detached: true, env: process.env, stdio: "ignore", windowsHide: true,
  }));

export async function openLocalDirectory(path: string): Promise<void> {
  if (!statSync(path).isDirectory()) {
    throw new Error("工作区路径不是目录。");
  }
  if (process.platform === "darwin") {
    await spawnDetached("/usr/bin/open", [path]);
    return;
  }
  if (process.platform === "win32") {
    await spawnDetached("explorer.exe", [path]);
    return;
  }
  await spawnDetached("xdg-open", [path]);
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = LOCAL_PATH_OPEN_ACTOR_ENTRY.invoke(undefined, command, args);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
