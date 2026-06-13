import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LingStackUserConfigPaths {
  readonly rootDir: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly providersDir: string;
  readonly providerProfilesPath: string;
  readonly pluginsDir: string;
  readonly pluginCacheDir: string;
  readonly stateDir: string;
  readonly recentWorkspacesPath: string;
  readonly daemonStatePath: string;
  readonly logsDir: string;
}

export interface LingStackRuntimePaths {
  readonly cwd: string;
  readonly rootDir: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly runtimeSettingsPath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly piDir: string;
  readonly pluginsDir: string;
  readonly pluginCacheDir: string;
}

export interface LingStackConfigPaths {
  readonly cwd: string;
  readonly user: LingStackUserConfigPaths;
  readonly workspace: LingStackRuntimePaths;
}

export interface ResolveUserConfigPathsOptions {
  readonly homeDir?: string;
  readonly userRootDir?: string;
  readonly env?: Record<string, string | undefined>;
}

export type ResolveConfigPathsOptions = ResolveUserConfigPathsOptions;

const userRootEnvName = "LING_STACK_HOME";

export function resolveUserConfigPaths(options: ResolveUserConfigPathsOptions = {}): LingStackUserConfigPaths {
  const env = options.env ?? process.env;
  const configuredRoot = options.userRootDir ?? env[userRootEnvName];
  const rootDir = resolve(configuredRoot && configuredRoot.trim() ? configuredRoot : join(options.homeDir ?? homedir(), ".ling-stack"));
  return {
    rootDir,
    configPath: join(rootDir, "config.json"),
    settingsPath: join(rootDir, "settings.json"),
    providersDir: join(rootDir, "providers"),
    providerProfilesPath: join(rootDir, "providers", "profiles.json"),
    pluginsDir: join(rootDir, "plugins"),
    pluginCacheDir: join(rootDir, "plugins", "cache"),
    stateDir: join(rootDir, "state"),
    recentWorkspacesPath: join(rootDir, "state", "recent-workspaces.json"),
    daemonStatePath: join(rootDir, "state", "daemon.json"),
    logsDir: join(rootDir, "logs"),
  };
}

export function resolveConfigPaths(cwd: string, options: ResolveConfigPathsOptions = {}): LingStackConfigPaths {
  const workspace = resolveRuntimePaths(cwd);
  return {
    cwd: workspace.cwd,
    user: resolveUserConfigPaths(options),
    workspace,
  };
}

export function resolveRuntimePaths(cwd: string): LingStackRuntimePaths {
  const resolvedCwd = resolve(cwd);
  const rootDir = join(resolvedCwd, ".ling-stack");
  return {
    cwd: resolvedCwd,
    rootDir,
    configPath: join(rootDir, "config.json"),
    databasePath: join(rootDir, "ling-stack.sqlite"),
    runtimeSettingsPath: join(rootDir, "runtime-settings.json"),
    sessionsDir: join(rootDir, "sessions"),
    artifactsDir: join(rootDir, "artifacts"),
    attachmentsDir: join(rootDir, "attachments"),
    logsDir: join(rootDir, "logs"),
    piDir: join(rootDir, "pi"),
    pluginsDir: join(rootDir, "plugins"),
    pluginCacheDir: join(rootDir, "plugins", "cache"),
  };
}

export function ensureRuntimePaths(paths: LingStackRuntimePaths): void {
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.attachmentsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.piDir, { recursive: true });
  mkdirSync(paths.pluginsDir, { recursive: true });
  mkdirSync(paths.pluginCacheDir, { recursive: true });
}

export function getRunEventLogPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.jsonl`);
}

export function getRunSummaryPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.summary.json`);
}
