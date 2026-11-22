import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface AppServerGitHubSourceConfig {
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly secretRef?: string;
}

export const githubRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u;

export function resolveAppServerGitHubSources(
  configured: readonly AppServerGitHubSourceConfig[] | undefined,
): readonly AppServerGitHubSourceConfig[] {
  const configPath = process.env.LING_STACK_APP_SERVER_GITHUB_SOURCES_FILE;
  let sources = configured;
  if (sources === undefined && configPath) {
    try { sources = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("The App Server GitHub source file must contain valid JSON."); }
  }
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length > 64) throw new Error("App Server GitHub sources must be a bounded array.");
  const seen = new Set<string>();
  return sources.map((config: AppServerGitHubSourceConfig) => {
    if (!config || typeof config.repository !== "string" || !githubRepositoryPattern.test(config.repository)
      || typeof config.repositoryId !== "string" || !/^[1-9]\d{0,19}$/u.test(config.repositoryId)
      || typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)
      || config.secretRef !== undefined && (typeof config.secretRef !== "string" || !config.secretRef.trim() || config.secretRef.length > 256)) {
      throw new Error("Invalid App Server GitHub source configuration.");
    }
    const workspaceRoot = realpathSync(config.workspaceRoot);
    const repository = config.repository.toLowerCase();
    const key = JSON.stringify([workspaceRoot, repository]);
    if (seen.has(key)) throw new Error("Duplicate App Server GitHub source for a workspace.");
    seen.add(key);
    return { workspaceRoot, repository, repositoryId: config.repositoryId, secretRef: config.secretRef };
  });
}
