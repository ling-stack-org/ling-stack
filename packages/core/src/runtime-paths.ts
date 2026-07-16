import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export interface LingStackUserConfigPaths {
  readonly rootDir: string;
  readonly configPath: string;
  readonly settingsPath: string;
  readonly providersDir: string;
  readonly providerProfilesPath: string;
  readonly pluginsDir: string;
  readonly pluginCacheDir: string;
  readonly sourcesDir: string;
  readonly stateDir: string;
  readonly recentWorkspacesPath: string;
  readonly daemonStatePath: string;
  readonly globalDatabasePath: string;
  readonly workspacesDir: string;
  readonly logsDir: string;
}

export type WorkspaceStateLocation = "repo-local" | "user-data-dir";

export interface WorkspaceStorageIdentity {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly displayName: string;
  readonly fingerprint: Record<string, unknown>;
}

export interface LingStackRuntimePaths {
  readonly cwd: string;
  readonly stateLocation: WorkspaceStateLocation;
  readonly identity: WorkspaceStorageIdentity;
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
  readonly worktreesDir: string;
  readonly memoryExportsDir: string;
}

export interface LingStackConfigPaths {
  readonly cwd: string;
  readonly user: LingStackUserConfigPaths;
  readonly workspace: LingStackRuntimePaths;
}

export interface ResolveUserConfigPathsOptions {
  readonly homeDir?: string;
  readonly userRootDir?: string;
  readonly workspaceStateLocation?: WorkspaceStateLocation;
  readonly env?: Record<string, string | undefined>;
}

export type ResolveConfigPathsOptions = ResolveUserConfigPathsOptions;

const userRootEnvName = "LING_STACK_HOME";
const workspaceStateLocations = new Set<WorkspaceStateLocation>(["repo-local", "user-data-dir"]);

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
    sourcesDir: join(rootDir, "sources"),
    stateDir: join(rootDir, "state"),
    recentWorkspacesPath: join(rootDir, "state", "recent-workspaces.json"),
    daemonStatePath: join(rootDir, "state", "daemon.json"),
    globalDatabasePath: join(rootDir, "global.sqlite"),
    workspacesDir: join(rootDir, "workspaces"),
    logsDir: join(rootDir, "logs"),
  };
}

export function resolveConfigPaths(cwd: string, options: ResolveConfigPathsOptions = {}): LingStackConfigPaths {
  return resolveStoragePaths(cwd, options);
}

export function resolveRuntimePaths(cwd: string): LingStackRuntimePaths {
  const resolvedCwd = resolve(cwd);
  return buildRuntimePaths(resolvedCwd, resolveUserConfigPaths(), "repo-local");
}

export function resolveStoragePaths(cwd: string, options: ResolveConfigPathsOptions = {}): LingStackConfigPaths {
  const resolvedCwd = resolve(cwd);
  const user = resolveUserConfigPaths(options);
  const stateLocation = resolveWorkspaceStateLocation(resolvedCwd, user, options);
  return {
    cwd: resolvedCwd,
    user,
    workspace: buildRuntimePaths(resolvedCwd, user, stateLocation),
  };
}

export function isWorkspaceStateLocation(value: unknown): value is WorkspaceStateLocation {
  return typeof value === "string" && workspaceStateLocations.has(value as WorkspaceStateLocation);
}

function resolveWorkspaceStateLocation(
  resolvedCwd: string,
  user: LingStackUserConfigPaths,
  options: ResolveConfigPathsOptions,
): WorkspaceStateLocation {
  if (options.workspaceStateLocation !== undefined) {
    if (!isWorkspaceStateLocation(options.workspaceStateLocation)) {
      throw new Error(`Unsupported workspace state location: ${String(options.workspaceStateLocation)}`);
    }
    return options.workspaceStateLocation;
  }
  return readWorkspaceStateLocationFromRepoConfig(resolvedCwd) ??
    readWorkspaceStateLocationFromRegistry(resolvedCwd, user) ??
    "repo-local";
}

function readWorkspaceStateLocationFromRepoConfig(resolvedCwd: string): WorkspaceStateLocation | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(resolvedCwd, ".ling-stack", "config.json"), "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const stateLocation = parsed.workspaceStateLocation;
    return isWorkspaceStateLocation(stateLocation) ? stateLocation : undefined;
  } catch {
    return undefined;
  }
}

function readWorkspaceStateLocationFromRegistry(
  resolvedCwd: string,
  user: LingStackUserConfigPaths,
): WorkspaceStateLocation | undefined {
  if (!existsSync(user.globalDatabasePath)) {
    return undefined;
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(user.globalDatabasePath);
    const row = database
      .prepare("SELECT state_location FROM workspaces_registry WHERE canonical_cwd = ? AND archived_at IS NULL ORDER BY last_opened_at DESC LIMIT 1")
      .get(resolvedCwd) as Record<string, SQLOutputValue> | undefined;
    const stateLocation = row?.state_location;
    return isWorkspaceStateLocation(stateLocation) ? stateLocation : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRuntimePaths(
  resolvedCwd: string,
  user: LingStackUserConfigPaths,
  stateLocation: WorkspaceStateLocation,
): LingStackRuntimePaths {
  const identity = createWorkspaceStorageIdentity(resolvedCwd);
  const rootDir = stateLocation === "user-data-dir"
    ? join(user.workspacesDir, identity.workspaceId)
    : join(resolvedCwd, ".ling-stack");
  return {
    cwd: resolvedCwd,
    stateLocation,
    identity,
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
    worktreesDir: join(rootDir, "worktrees"),
    memoryExportsDir: join(rootDir, "exports", "memory"),
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
  mkdirSync(paths.worktreesDir, { recursive: true });
  mkdirSync(paths.memoryExportsDir, { recursive: true });
}

export function getRunEventLogPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.jsonl`);
}

export function getRunSummaryPath(paths: LingStackRuntimePaths, runId: string): string {
  return join(paths.sessionsDir, `${runId}.summary.json`);
}

export function createWorkspaceStorageIdentity(cwd: string): WorkspaceStorageIdentity {
  const canonicalCwd = resolve(cwd);
  const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 16);
  return {
    workspaceId: `workspace_${digest}`,
    canonicalCwd,
    displayName: canonicalCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? canonicalCwd,
    fingerprint: {
      canonicalCwd,
      strategy: "canonical-path-sha256-v1",
    },
  };
}
