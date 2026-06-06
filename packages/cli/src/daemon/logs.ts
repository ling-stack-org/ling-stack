import { readFile } from "node:fs/promises";
import type { DaemonLifecyclePaths, DaemonLifecycleState } from "./state.js";

export async function readDaemonLogLines(
  paths: DaemonLifecyclePaths,
  state: DaemonLifecycleState | undefined,
  lineCount: number,
): Promise<{ readonly logPath: string; readonly lines: readonly string[] }> {
  const logPath = state?.logPath ?? paths.logPath;
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (error) {
    throw new Error(`daemon_log_missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return {
    logPath,
    lines: lines.slice(Math.max(0, lines.length - lineCount)),
  };
}
