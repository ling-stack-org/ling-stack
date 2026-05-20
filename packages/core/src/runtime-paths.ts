import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LingStackRuntimePaths {
  readonly cwd: string;
  readonly rootDir: string;
  readonly databasePath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly piDir: string;
}

export function resolveRuntimePaths(cwd: string): LingStackRuntimePaths {
  const rootDir = join(cwd, ".ling-stack");
  return {
    cwd,
    rootDir,
    databasePath: join(rootDir, "ling-stack.sqlite"),
    sessionsDir: join(rootDir, "sessions"),
    artifactsDir: join(rootDir, "artifacts"),
    piDir: join(rootDir, "pi"),
  };
}

export function ensureRuntimePaths(paths: LingStackRuntimePaths): void {
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.piDir, { recursive: true });
}

export function getRunEventLogPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.jsonl`);
}

export function getRunSummaryPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.summary.json`);
}
