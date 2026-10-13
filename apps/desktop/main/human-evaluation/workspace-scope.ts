import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Bind one configured display alias to one canonical Host scope; never resolve a Renderer-supplied path. */
export function createHumanEvaluationWorkspaceScope(configuredCwd: string): {
  readonly workspaceCwd: string;
  readonly canonicalWorkspaceCwd: string;
  readonly current: () => boolean;
} {
  const workspaceCwd = resolve(configuredCwd);
  const canonicalWorkspaceCwd = realpathSync(workspaceCwd);
  return Object.freeze({ workspaceCwd, canonicalWorkspaceCwd,
    current: () => {
      try { return realpathSync(workspaceCwd) === canonicalWorkspaceCwd; }
      catch { return false; }
    } });
}
