import { spawn } from "node:child_process";
import { statSync } from "node:fs";

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
    const child = spawn(command, [...args], {
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
