import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeEnvironment, WorktreeInitialization } from "@ling-stack/contracts";
import { runWorkspaceTerminalCommand } from "../workspace-directory/terminal-runner.js";
import { git } from "./managed-worktrees.js";
import { writePrivateJson } from "./worktree-recovery.js";

interface InitializationRecord extends WorktreeInitialization { readonly fingerprint: string; readonly pid?: number }

export async function readWorktreeInitialization(path: string): Promise<InitializationRecord | undefined> {
  const directory = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  try {
    const raw = await readFile(join(directory, "ling-worktree-initialization.json"), "utf8");
    if (raw.length > 64000) throw new Error("Worktree initialization record is too large");
    const record = JSON.parse(raw) as InitializationRecord;
    if (!["running", "succeeded", "failed"].includes(record.status)) throw new Error("Invalid worktree initialization record");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Only a locally saved environment can select this manual terminal execution path. */
export async function initializeWorktree(path: string, environment?: WorktreeEnvironment, retry = false): Promise<WorktreeInitialization | undefined> {
  const existing = await readWorktreeInitialization(path);
  if (existing && !retry) return existing;
  if (existing?.status === "running" && retry) {
    if (!existing.pid) throw new Error("初始化进程状态未知，请检查本地进程后再处理初始化记录。");
    try { process.kill(process.platform === "win32" ? existing.pid : -existing.pid, 0); throw new Error("初始化命令仍在运行。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if (!environment?.enabled && !existing) return undefined;
  const directory = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const markerPath = join(directory, "ling-worktree-initialization.json");
  const fingerprint = createHash("sha256").update(JSON.stringify(environment ?? {})).digest("hex");
  writePrivateJson(markerPath, { status: "running", fingerprint });
  let result: InitializationRecord;
  try {
    const command = environment?.enabled ? await runWorkspaceTerminalCommand({ cwd: path, command: environment.setupScript,
      environment: environment.variables, timeoutMs: environment.timeoutSeconds * 1000, outputLimitBytes: 8000, stopProcessGroup: true,
      onSpawn: (pid) => writePrivateJson(markerPath, { status: "running", fingerprint, pid }) }) : undefined;
    let output = command ? [command.stdout, command.stderr].filter(Boolean).join("\n") : "";
    for (const secret of Object.values(environment?.variables ?? {})) if (secret) output = output.split(secret).join("[redacted]");
    result = { status: !command || command.status === "succeeded" ? "succeeded" : "failed", fingerprint,
      output: output.slice(0, 16000), completedAt: new Date().toISOString(),
      ...(command && command.status !== "succeeded" ? { errorMessage: command.status === "timed_out" ? "初始化脚本超时。" : `初始化脚本失败（${command.exitCode ?? command.signal ?? "unknown"}）。` } : {}) };
  } catch {
    result = { status: "failed", fingerprint, completedAt: new Date().toISOString(), errorMessage: "初始化脚本无法执行。" };
  }
  writePrivateJson(markerPath, result);
  return result;
}
